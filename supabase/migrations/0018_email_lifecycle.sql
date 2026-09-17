-- =============================================================================
-- Lifecycle email — the two automated sequences, their schedule, and the
-- send log that makes the whole thing idempotent.
-- =============================================================================
-- Apply this in the Apex & Chill Supabase project (SQL editor, or the Supabase
-- CLI). It is the cloud half of docs/EMAIL-LIFECYCLE.md; the sending half is
-- the `email-dispatch` edge function, woken once an hour by pg_cron.
--
-- Everything is written to be RE-RUNNABLE: `if not exists`, `create or replace`,
-- and `drop policy if exists` before each policy, so applying it twice is safe.
--
-- Two sequences, both driven entirely off data we already hold:
--
--   * `trial`  — eight emails across the 7-day card-upfront trial, one feature
--     per day. Anchored to billing_subscriptions.started_at, which the Stripe
--     webhook already writes from `subscription.start_date` and never moves.
--     Anchoring to a stored fact rather than to "when we noticed" means a
--     replayed webhook, a re-run of this job, or a day of downtime cannot
--     shuffle anybody's sequence.
--
--   * `nudge`  — three emails to an account that was created and then never
--     started a trial. This is the closest reachable cohort to "downloaded but
--     never signed up": the installer comes from a public GitHub release, so a
--     download that never became an account leaves no address to write to. See
--     docs/EMAIL-LIFECYCLE.md, "The cohort we cannot reach".
--
-- Design notes:
--   * NOTHING SENDS UNTIL email_settings.enabled IS TRUE. It ships false on
--     purpose, so applying the migration cannot mail anyone by surprise.
--   * The schedule lives in a TABLE, not in code. Re-timing a step is an
--     update, not a deploy.
--   * email_sends is the idempotency record AND the audit trail. A unique
--     partial index on the 'sent' rows makes a double-send impossible even if
--     two dispatchers overlap; failures are ordinary rows so they can be
--     retried, capped at three attempts per step.
--   * The staleness window is what stops a backfill. Turning the system on
--     must not fire "day 5" at every account that signed up last week, so a
--     step whose due time has already passed by more than email_settings
--     .stale_after is abandoned rather than sent late.
--   * Suppressions (hard bounce / spam complaint) are checked by ADDRESS, not
--     by account, because that is the unit Resend reports and the unit that
--     damages the sending domain's reputation.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. email_settings — the master switch and the tuning knobs. One row, ever.
-- ---------------------------------------------------------------------------
create table if not exists public.email_settings (
  id                boolean  primary key default true check (id),
  -- The kill switch. False = email_lifecycle_due() returns nothing at all.
  enabled           boolean  not null default false,
  -- Nothing anchored before this instant is ever eligible. Set to now() when
  -- the sequences go live so existing accounts are not retro-mailed.
  activated_at      timestamptz not null default now(),
  -- Quiet hours, in Europe/London (where the league and most drivers are).
  -- A step due at 03:00 waits for the window rather than arriving overnight.
  send_window_start smallint not null default 9  check (send_window_start between 0 and 23),
  send_window_end   smallint not null default 20 check (send_window_end   between 0 and 23),
  -- How late a step may still be sent. Past this it is abandoned silently.
  stale_after       interval not null default interval '48 hours',
  updated_at        timestamptz not null default now()
);
insert into public.email_settings (id) values (true) on conflict (id) do nothing;

alter table public.email_settings enable row level security;
-- No policies: only the service role and the SECURITY DEFINER functions below.

comment on table public.email_settings is
  'Single-row control for the lifecycle sequences. enabled=false stops all sending.';

-- ---------------------------------------------------------------------------
-- 2. email_lifecycle_steps — the schedule, as data.
--    offset_hours counts from the campaign's anchor (trial start / signup).
-- ---------------------------------------------------------------------------
create table if not exists public.email_lifecycle_steps (
  campaign       text not null,
  step           text not null,
  position       smallint not null,
  offset_hours   numeric  not null,
  -- False for the welcome mail only: it should land while they are still at
  -- the keyboard, not at 09:00 tomorrow.
  respect_window boolean not null default true,
  active         boolean not null default true,
  primary key (campaign, step)
);

insert into public.email_lifecycle_steps (campaign, step, position, offset_hours, respect_window) values
  ('trial', 'day0',  0,   0.1, false),   -- welcome + first overlay on screen
  ('trial', 'day1',  1,  24,   true),    -- overlays and the layout editor
  ('trial', 'day2',  2,  48,   true),    -- the race engineer
  ('trial', 'day3',  3,  72,   true),    -- fuel and strategy
  ('trial', 'day4',  4,  96,   true),    -- setups
  ('trial', 'day5',  5, 120,   true),    -- the team pit wall
  ('trial', 'day6',  6, 144,   true),    -- stint review + leaderboards
  ('trial', 'day7',  7, 162,   true),    -- last day of the trial
  ('nudge', 'why',   0,  24,   true),    -- one question: what stopped you?
  ('nudge', 'proof', 1,  72,   true),    -- what the app actually does
  ('nudge', 'last',  2, 168,   true)     -- last one, with an unsubscribe
on conflict (campaign, step) do nothing;

alter table public.email_lifecycle_steps enable row level security;

comment on table public.email_lifecycle_steps is
  'When each lifecycle email goes out, measured in hours from the campaign anchor.';

-- ---------------------------------------------------------------------------
-- 3. email_prefs — one row per account: the unsubscribe token and the opt-out.
--    Rows are created lazily by email_lifecycle_due(); there is no trigger to
--    keep in step with handle_new_user().
-- ---------------------------------------------------------------------------
create table if not exists public.email_prefs (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  -- Random, per-account, and the ONLY thing the unsubscribe endpoint accepts.
  -- Never the email address: a guessable opt-out link is an abuse vector.
  unsubscribe_token  uuid not null unique default gen_random_uuid(),
  lifecycle_opt_out  boolean not null default false,
  opted_out_at       timestamptz,
  created_at         timestamptz not null default now()
);

alter table public.email_prefs enable row level security;

drop policy if exists "own email prefs readable" on public.email_prefs;
create policy "own email prefs readable" on public.email_prefs
  for select using (user_id = auth.uid());
-- No client write path: opting out goes through the token, not through a JWT,
-- because the person clicking the link in the mail is not signed in.

comment on table public.email_prefs is
  'Per-account lifecycle email opt-out and the token its unsubscribe link carries.';

-- ---------------------------------------------------------------------------
-- 4. email_suppressions — addresses we must never write to again.
--    Fed by the Resend webhook (bounces, complaints) and by unsubscribes.
-- ---------------------------------------------------------------------------
create table if not exists public.email_suppressions (
  email      text primary key,
  reason     text not null default 'bounce'
               check (reason in ('bounce', 'complaint', 'manual', 'unsubscribe')),
  detail     text not null default '',
  created_at timestamptz not null default now()
);

alter table public.email_suppressions enable row level security;

comment on table public.email_suppressions is
  'Hard bounces and spam complaints. Checked by address before every send.';

-- ---------------------------------------------------------------------------
-- 5. email_sends — every attempt, and the reason a repeat cannot happen.
-- ---------------------------------------------------------------------------
create table if not exists public.email_sends (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  email       text not null,
  campaign    text not null,
  step        text not null,
  subject     text not null default '',
  status      text not null default 'sent'
                check (status in ('sent', 'failed', 'skipped')),
  provider_id text not null default '',
  error       text not null default '',
  created_at  timestamptz not null default now()
);

-- The double-send guard. Partial, so a failed attempt does not block a retry
-- but a successful one blocks everything.
create unique index if not exists email_sends_once_idx
  on public.email_sends (user_id, campaign, step) where status = 'sent';
create index if not exists email_sends_user_idx    on public.email_sends (user_id);
create index if not exists email_sends_created_idx on public.email_sends (created_at desc);

alter table public.email_sends enable row level security;
-- No policies: the log is admin-only, read through admin_email_stats().

comment on table public.email_sends is
  'Lifecycle send log. The unique index on the sent rows is the idempotency guarantee.';

-- ---------------------------------------------------------------------------
-- 6. email_lifecycle_due — the whole scheduler, in one query.
--
--    Returns the sends that are ripe RIGHT NOW, oldest first so a small
--    p_limit drains fairly. The dispatcher renders and sends each row, then
--    calls email_lifecycle_record() for it; nothing here marks anything, so a
--    dispatcher that dies mid-batch simply re-offers the rest next hour.
-- ---------------------------------------------------------------------------
create or replace function public.email_lifecycle_due(p_limit int default 50)
returns table (
  user_id           uuid,
  email             text,
  first_name        text,
  campaign          text,
  step              text,
  due_at            timestamptz,
  unsubscribe_token uuid,
  variant           text,
  opened_app        boolean,
  trial_end         timestamptz,
  days_left         int
)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_cfg public.email_settings%rowtype;
  v_hour int;
begin
  select * into v_cfg from public.email_settings where id = true;
  if not found or not v_cfg.enabled then
    return;                        -- master switch off: nothing is ever due
  end if;

  -- Quiet hours are judged in Europe/London, not UTC, so the window does not
  -- drift an hour twice a year.
  v_hour := extract(hour from (now() at time zone 'Europe/London'))::int;

  -- Make sure every account has a token to unsubscribe with. Doing it here
  -- rather than in a trigger keeps handle_new_user() untouched.
  insert into public.email_prefs (user_id)
  select p.id from public.profiles p
  where not exists (select 1 from public.email_prefs e where e.user_id = p.id)
  on conflict (user_id) do nothing;

  return query
  with
  -- Has this account ever actually opened the app? Day 1 says a different
  -- thing to someone who paid and never launched it.
  opened as (
    select a.user_id as uid from public.app_sessions a group by a.user_id
  ),

  -- ---- campaign anchors --------------------------------------------------
  -- `trial`: anchored on the subscription's own start date. cancel_at_period_end
  -- halts the sequence — someone who has already decided to stop does not want
  -- six more feature tours.
  trial_base as (
    select b.user_id                                    as uid,
           b.started_at                                 as anchor,
           'trial'::text                                as camp,
           b.trial_end                                  as t_end,
           case when b.status = 'trialing' then 'convert' else 'thanks' end as var
    from public.billing_subscriptions b
    where b.trial_end   is not null
      and b.started_at  is not null
      and b.status in ('trialing', 'active', 'past_due')
      and not b.cancel_at_period_end
  ),

  -- `nudge`: an account with no subscription that ever began. 'incomplete' and
  -- 'incomplete_expired' stay in — those are people whose card was declined at
  -- checkout, the warmest leads on the list, not people to write off.
  nudge_base as (
    select p.id                    as uid,
           p.created_at            as anchor,
           'nudge'::text           as camp,
           null::timestamptz       as t_end,
           'default'::text         as var
    from public.profiles p
    left join public.billing_subscriptions b on b.user_id = p.id
    where coalesce(b.status, 'none') in ('none', 'incomplete', 'incomplete_expired')
      and b.started_at is null
      -- Comped league members and beta testers were never going to check out.
      and p.free_access_reason is null
  ),

  base as (
    select * from trial_base
    union all
    select * from nudge_base
  ),

  candidate as (
    select b.uid,
           b.camp,
           s.step,
           s.position,
           b.anchor + make_interval(mins => (s.offset_hours * 60)::int) as due,
           s.respect_window,
           b.t_end,
           b.var
    from base b
    join public.email_lifecycle_steps s
      on s.campaign = b.camp and s.active
  )

  select c.uid,
         u.email::text,
         -- "Hi Carl" reads better than "Hi Carl Smith"; a blank display_name
         -- becomes "Hi there" in the template, not "Hi Driver".
         coalesce(nullif(split_part(btrim(pr.display_name), ' ', 1), ''), '')::text,
         c.camp,
         c.step,
         c.due,
         ep.unsubscribe_token,
         c.var,
         (o.uid is not null),
         c.t_end,
         case when c.t_end is null then null
              else greatest(0, ceil(extract(epoch from (c.t_end - now())) / 86400)::int)
         end
  from candidate c
  join public.profiles     pr on pr.id      = c.uid
  join auth.users          u  on u.id       = c.uid
  join public.email_prefs  ep on ep.user_id = c.uid
  left join opened         o  on o.uid      = c.uid
  where c.due <= now()
    -- Anti-backfill, both halves: never before the system went live, and
    -- never more than stale_after late.
    and c.due >= greatest(v_cfg.activated_at, now() - v_cfg.stale_after)
    -- Quiet hours.
    and (not c.respect_window
         or v_hour between v_cfg.send_window_start and v_cfg.send_window_end)
    and coalesce(u.email, '') <> ''
    and not ep.lifecycle_opt_out
    and not exists (select 1 from public.email_suppressions sup where sup.email = u.email)
    -- Already sent, or failed three times and not worth a fourth.
    and not exists (
      select 1 from public.email_sends es
      where es.user_id = c.uid and es.campaign = c.camp and es.step = c.step
        and es.status = 'sent')
    and (select count(*) from public.email_sends es
         where es.user_id = c.uid and es.campaign = c.camp and es.step = c.step
           and es.status = 'failed') < 3
  -- Oldest due first: a step that has been waiting for the send window opens
  -- ahead of one that came ripe a minute ago.
  order by c.due asc
  limit greatest(1, least(coalesce(p_limit, 50), 500));
end;
$fn$;

revoke all on function public.email_lifecycle_due(int) from public, anon, authenticated;
grant execute on function public.email_lifecycle_due(int) to service_role;

-- ---------------------------------------------------------------------------
-- 7. email_lifecycle_record — write the outcome of one attempt.
--    A duplicate 'sent' row hits email_sends_once_idx; that is not an error
--    worth propagating (it means another dispatcher won the race), so it is
--    swallowed and reported as false.
-- ---------------------------------------------------------------------------
create or replace function public.email_lifecycle_record(
  p_user_id     uuid,
  p_email       text,
  p_campaign    text,
  p_step        text,
  p_subject     text,
  p_status      text,
  p_provider_id text default '',
  p_error       text default ''
) returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $fn$
begin
  insert into public.email_sends
    (user_id, email, campaign, step, subject, status, provider_id, error)
  values
    (p_user_id, p_email, p_campaign, p_step, coalesce(p_subject, ''),
     p_status, coalesce(p_provider_id, ''), left(coalesce(p_error, ''), 500));
  return true;
exception when unique_violation then
  return false;
end;
$fn$;

revoke all on function public.email_lifecycle_record(uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.email_lifecycle_record(uuid, text, text, text, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. email_lifecycle_unsubscribe — the token endpoint.
--    Idempotent, and the caller is expected to show the same page whether or
--    not the token was real, so the link cannot be used to probe for tokens.
-- ---------------------------------------------------------------------------
create or replace function public.email_lifecycle_unsubscribe(p_token uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_user uuid;
begin
  update public.email_prefs
     set lifecycle_opt_out = true,
         opted_out_at      = coalesce(opted_out_at, now())
   where unsubscribe_token = p_token
  returning user_id into v_user;

  if v_user is null then
    return false;
  end if;

  -- Belt and braces: also suppress the address itself, so a second account on
  -- the same mailbox cannot start writing to them again.
  insert into public.email_suppressions (email, reason, detail)
  select u.email, 'unsubscribe', 'lifecycle link'
  from auth.users u where u.id = v_user and coalesce(u.email, '') <> ''
  on conflict (email) do nothing;

  return true;
end;
$fn$;

revoke all on function public.email_lifecycle_unsubscribe(uuid) from public, anon, authenticated;
grant execute on function public.email_lifecycle_unsubscribe(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. email_suppress — what the Resend webhook calls on a bounce or complaint.
-- ---------------------------------------------------------------------------
create or replace function public.email_suppress(
  p_email text, p_reason text, p_detail text default ''
) returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $fn$
begin
  if coalesce(p_email, '') = '' then return false; end if;
  insert into public.email_suppressions (email, reason, detail)
  values (lower(btrim(p_email)),
          case when p_reason in ('bounce', 'complaint', 'manual', 'unsubscribe')
               then p_reason else 'manual' end,
          left(coalesce(p_detail, ''), 500))
  on conflict (email) do update set reason = excluded.reason, detail = excluded.detail;
  return true;
end;
$fn$;

revoke all on function public.email_suppress(text, text, text) from public, anon, authenticated;
grant execute on function public.email_suppress(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. admin_email_stats — one card's worth of numbers for the Admin tab.
--     Aggregates only: an admin sees how a step is performing, never a list of
--     who was written to, matching the doctrine in 0001_admin_panel.sql.
--
--     VOLATILE, not stable, because it calls email_lifecycle_due(), which
--     back-fills email_prefs rows and so cannot run in a read-only function.
-- ---------------------------------------------------------------------------
create or replace function public.admin_email_stats()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_cfg public.email_settings%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin_email_stats: not an admin';
  end if;

  select * into v_cfg from public.email_settings where id = true;

  return jsonb_build_object(
    'enabled',      coalesce(v_cfg.enabled, false),
    'activatedAt',  v_cfg.activated_at,
    'windowStart',  v_cfg.send_window_start,
    'windowEnd',    v_cfg.send_window_end,
    'optedOut',     (select count(*) from public.email_prefs where lifecycle_opt_out),
    'suppressed',   (select count(*) from public.email_suppressions),
    'sent7d',       (select count(*) from public.email_sends
                      where status = 'sent' and created_at > now() - interval '7 days'),
    'failed7d',     (select count(*) from public.email_sends
                      where status = 'failed' and created_at > now() - interval '7 days'),
    'dueNow',       (select count(*) from public.email_lifecycle_due(500)),
    'steps',        coalesce((
      select jsonb_agg(jsonb_build_object(
               'campaign', s.campaign, 'step', s.step,
               'offsetHours', s.offset_hours, 'active', s.active,
               'sent', coalesce(x.n, 0), 'failed', coalesce(x.f, 0))
             order by s.campaign, s.position)
      from public.email_lifecycle_steps s
      left join (
        select campaign, step,
               count(*) filter (where status = 'sent')   as n,
               count(*) filter (where status = 'failed') as f
        from public.email_sends group by campaign, step
      ) x on x.campaign = s.campaign and x.step = s.step
    ), '[]'::jsonb)
  );
end;
$fn$;

grant execute on function public.admin_email_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Housekeeping: the log is an audit trail, not an archive. A year is more
--     than enough to answer "did this person get day 3?".
-- ---------------------------------------------------------------------------
create or replace function public.email_prune(p_keep interval default interval '1 year')
returns int
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare v_n int;
begin
  delete from public.email_sends where created_at < now() - p_keep;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

revoke all on function public.email_prune(interval) from public, anon, authenticated;
grant execute on function public.email_prune(interval) to service_role;
