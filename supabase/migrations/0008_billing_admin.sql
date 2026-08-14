-- =============================================================================
-- Billing, seen from the Admin tab — how many ride free, how many are on trial,
-- how many pay, what that is worth a month, and how many leave.
-- =============================================================================
-- Apply after 0007_billing.sql. Re-runnable (`if not exists`, `create or
-- replace`, and an explicit drop before the one function whose SHAPE changes).
--
-- WHY THE NEW COLUMNS EXIST
-- 0007 stores the CURRENT state of each subscription and nothing else, which
-- answers "who may use the app?" perfectly and "what did MRR do since March?"
-- not at all. Rather than bolt on an event log and a cron job, this migration
-- adds the four facts a subscription needs for its whole life to be
-- reconstructed on demand:
--
--     started_at    when Stripe says the subscription began
--     ended_at      when it finally stopped (null while it is alive)
--     monthly_pence what it is worth per MONTH, whatever the billing interval
--     currency      so a future multi-currency price cannot silently sum wrong
--
-- With those, "was this subscription paying at instant T?" is a WHERE clause,
-- and MRR and churn for any month fall out of it. The cost of that simplicity
-- is one honest limitation: billing_subscriptions is keyed on user_id, one row
-- per account, so a driver who cancels and later resubscribes overwrites their
-- own history and reads as a single unbroken run. For a league of this size
-- that is the right trade; Stripe's own dashboard remains the source of truth
-- for anything financial. The UI says as much rather than implying otherwise.
--
-- History only accrues from the day the webhook starts writing these columns.
-- That costs nothing here because the paywall has not launched — there is
-- exactly one subscription on the account and it is a test.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The four lifecycle facts. Written by the stripe-webhook edge function on
--    every subscription event, exactly like the columns 0007 added.
-- ---------------------------------------------------------------------------
alter table public.billing_subscriptions
  add column if not exists started_at    timestamptz,
  add column if not exists ended_at      timestamptz,
  add column if not exists monthly_pence integer,
  add column if not exists currency      text;

-- Backfill whatever we can for rows that predate this migration. `updated_at`
-- is the only date we kept, so it stands in for "started" — wrong by at most
-- the age of the paywall, which is days. Anything already dead stays null
-- rather than inventing an end date it never had.
update public.billing_subscriptions
   set started_at = coalesce(started_at, updated_at)
 where status in ('trialing', 'active', 'past_due');

update public.billing_subscriptions
   set monthly_pence = coalesce(monthly_pence, 499),
       currency      = coalesce(currency, 'gbp')
 where status in ('trialing', 'active', 'past_due');

-- ---------------------------------------------------------------------------
-- 2. entitlement_status — unchanged except for the admin fail-safe.
-- ---------------------------------------------------------------------------
-- THE BUG THIS FIXES: the Admin tab is where comps are granted, and the Admin
-- tab sits behind the entitlement gate. An admin whose own comp lapsed was
-- therefore locked out of the only tool that could restore it — including for
-- themselves. Hit for real while testing the paywall.
--
-- is_admin is set in the database by hand, never by anything a client can
-- reach, so honouring it here grants nothing that staff could not already
-- grant themselves one click later. It is a lock that cannot shut you out of
-- your own house, not a new door.
create or replace function public.entitlement_status()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_reason   text;
  v_is_admin boolean := false;
  v_sub      public.billing_subscriptions%rowtype;
  v_live     boolean := false;
begin
  if v_uid is null then
    return json_build_object('entitled', false, 'source', null);
  end if;

  select p.free_access_reason, coalesce(p.is_admin, false)
    into v_reason, v_is_admin
    from public.profiles p where p.id = v_uid;

  select * into v_sub
    from public.billing_subscriptions s where s.user_id = v_uid;

  -- trialing/active are obviously live; past_due rides Stripe's dunning window
  -- so one bounced card doesn't black-screen a race weekend.
  v_live := coalesce(v_sub.status, 'none') in ('trialing', 'active', 'past_due');

  return json_build_object(
    'entitled', (v_reason is not null) or v_live or v_is_admin,
    -- A comp wins the label even alongside a live sub: it's the stronger claim.
    -- An admin with neither reads as 'staff', which is what they are; note that
    -- this is NOT a row in profiles, so such an account does not appear in the
    -- Free access list until someone comps it properly.
    'source', case
                when v_reason is not null then 'free'
                when v_live then 'stripe'
                when v_is_admin then 'free'
                else null
              end,
    'freeReason', coalesce(v_reason, case when v_is_admin then 'staff' end),
    'status', coalesce(v_sub.status, 'none'),
    'cancelAtPeriodEnd', coalesce(v_sub.cancel_at_period_end, false),
    'trialEnd', v_sub.trial_end,
    'currentPeriodEnd', v_sub.current_period_end,
    'hasCustomer', v_sub.stripe_customer_id is not null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. admin_billing_overview — everything the Billing section of the Admin tab
--    draws, as one JSON object and one round trip.
-- ---------------------------------------------------------------------------
-- Buckets are MUTUALLY EXCLUSIVE and cover every account, so the mix chart
-- always sums to the roster: a comp outranks a subscription (same rule
-- entitlement_status uses for its label), and an account that has never
-- subscribed at all lands in 'none'.
--
-- MRR counts 'active' only. A trial is worth £0 until it converts, and a
-- past_due subscription is revenue we have not been paid — counting either
-- would flatter the number, and the whole point of putting it on screen is to
-- be able to trust it.
create or replace function public.admin_billing_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  with cls as (
    select p.id,
           case
             when p.free_access_reason is not null then 'free'
             when b.status = 'trialing' then 'trial'
             when b.status = 'active'   then 'paying'
             when b.status = 'past_due' then 'past_due'
             when b.status is not null and b.status <> 'none' then 'lapsed'
             else 'none'
           end as bucket
      from public.profiles p
      left join public.billing_subscriptions b on b.user_id = p.id
  ),
  -- The last 12 month starts, oldest first. Each row's window is [m, m_next).
  months as (
    select gs::date as m,
           (gs + interval '1 month')::timestamptz as m_next
      from generate_series(
             date_trunc('month', now()) - interval '11 months',
             date_trunc('month', now()),
             interval '1 month') gs
  ),
  series as (
    select mo.m,
           -- Measure the CURRENT month as it stands right now rather than at a
           -- month end that has not happened; a projected last point on a
           -- revenue chart is how people talk themselves into bad decisions.
           least(mo.m_next, now()) as t_end,
           mo.m::timestamptz       as t_start,
           mo.m_next               as m_next
      from months mo
  )
  select json_build_object(
    'mix', (
      select coalesce(json_object_agg(bucket, n), '{}'::json)
        from (select bucket, count(*) as n from cls group by bucket) g
    ),
    'freeByReason', (
      select coalesce(json_agg(json_build_object('reason', reason, 'users', n)
                               order by n desc, reason), '[]'::json)
        from (select coalesce(free_access_reason, 'league') as reason, count(*) as n
                from public.profiles
               where free_access_reason is not null
               group by 1) r
    ),
    'totalAccounts', (select count(*) from public.profiles),
    -- Today's run rate, in pence, from live subscriptions only.
    'mrrPence', (
      select coalesce(sum(monthly_pence), 0)
        from public.billing_subscriptions
       where status = 'active'
    ),
    'currency', (
      select coalesce(max(currency), 'gbp')
        from public.billing_subscriptions
       where currency is not null
    ),
    'series', (
      select coalesce(json_agg(json_build_object(
               'month',     to_char(s.m, 'YYYY-MM'),
               'mrrPence',  p.mrr_pence,
               'active',    p.active_now,
               'started',   p.started,
               'churned',   p.churned,
               -- Churn is measured against the subscribers who were there to
               -- lose at the START of the month. Nulled rather than zeroed when
               -- there was nobody: 0% churn out of 0 subscribers is not a fact,
               -- and drawing it as one flattens the chart with a lie.
               'churnRate', case when p.active_start > 0
                                 then round((p.churned::numeric / p.active_start) * 100, 1)
                                 else null end,
               'activeStart', p.active_start
             ) order by s.m), '[]'::json)
        from series s
        cross join lateral (
          select
            -- Paying at the end of the window: begun, not yet ended, and past
            -- any trial.
            coalesce(sum(b.monthly_pence) filter (
              where b.started_at <= s.t_end
                and (b.ended_at is null or b.ended_at > s.t_end)
                and (b.trial_end is null or b.trial_end <= s.t_end)
            ), 0)::bigint as mrr_pence,
            count(*) filter (
              where b.started_at <= s.t_end
                and (b.ended_at is null or b.ended_at > s.t_end)
                and (b.trial_end is null or b.trial_end <= s.t_end)
            )::bigint as active_now,
            count(*) filter (
              where b.started_at <= s.t_start
                and (b.ended_at is null or b.ended_at > s.t_start)
                and (b.trial_end is null or b.trial_end <= s.t_start)
            )::bigint as active_start,
            count(*) filter (
              where b.started_at >= s.t_start and b.started_at < s.m_next
            )::bigint as started,
            count(*) filter (
              where b.ended_at >= s.t_start and b.ended_at < s.m_next
            )::bigint as churned
          from public.billing_subscriptions b
        ) p
    )
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. admin_users_list — same roster, plus the two facts the Members section
--    needs to manage access from the row it is already looking at.
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: the RETURNS TABLE shape changes, and Postgres
-- will not let `create or replace` do that.
drop function if exists public.admin_users_list(text, text, int);

create or replace function public.admin_users_list(
  p_search text default null,
  p_sort   text default 'last_seen',
  p_limit  int  default 200
) returns table (
  user_id            uuid,
  name               text,
  email              text,
  logins             bigint,
  last_seen_at       timestamptz,
  first_seen_at      timestamptz,
  app_version        text,
  joined_at          timestamptz,
  is_admin           boolean,
  free_access_reason text,
  billing_status     text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_sort   text := lower(coalesce(p_sort, 'last_seen'));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  int  := greatest(1, least(coalesce(p_limit, 200), 1000));
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;
  -- Whitelist rather than interpolate: the sort arrives from the renderer, and
  -- the order-by below is static SQL precisely so it can never be anything else.
  if v_sort not in ('last_seen', 'logins', 'name', 'joined', 'access') then
    v_sort := 'last_seen';
  end if;

  return query
  with sess as (
    select a.user_id           as uid,
           count(*)            as n_logins,
           min(a.started_at)   as first_seen,
           max(a.last_seen_at) as last_seen
    from public.app_sessions a
    group by a.user_id
  ),
  lastver as (
    -- The version each driver most recently ran, so "still on an old build" is
    -- answerable per person and not just in aggregate.
    select distinct on (a.user_id) a.user_id as uid, a.app_version as ver
    from public.app_sessions a
    where a.app_version <> ''
    order by a.user_id, a.last_seen_at desc
  )
  -- Driven from profiles, not from sessions: an account that has never opened
  -- the app is exactly the row a league most wants to see, and an inner join
  -- would hide it.
  select p.id,
         coalesce(nullif(btrim(p.display_name), ''), 'Driver')::text,
         coalesce(u.email, '')::text,
         coalesce(s.n_logins, 0)::bigint,
         s.last_seen,
         s.first_seen,
         coalesce(l.ver, '')::text,
         p.created_at,
         coalesce(p.is_admin, false),
         p.free_access_reason::text,
         coalesce(b.status, 'none')::text
  from public.profiles p
  left join auth.users u                     on u.id      = p.id
  left join sess s                           on s.uid     = p.id
  left join lastver l                        on l.uid     = p.id
  left join public.billing_subscriptions b   on b.user_id = p.id
  where v_search is null
     or p.display_name ilike '%' || v_search || '%'
     or u.email ilike '%' || v_search || '%'
  order by
    case when v_sort = 'logins' then coalesce(s.n_logins, 0) end desc nulls last,
    case when v_sort = 'name'   then lower(nullif(btrim(p.display_name), '')) end asc nulls last,
    case when v_sort = 'joined' then p.created_at end desc nulls last,
    case when v_sort = 'last_seen' then s.last_seen end desc nulls last,
    -- 'access' groups the roster by how each account is paying — comped first,
    -- then live subscriptions, then everyone who is neither. That last group is
    -- the one worth looking at on the day the paywall lands.
    case when v_sort = 'access' then
      case
        when p.free_access_reason is not null then 0
        when coalesce(b.status, 'none') in ('trialing', 'active', 'past_due') then 1
        else 2
      end
    end asc nulls last,
    -- Tie-break, and the whole order for the sorts above once their key ties:
    -- most recently seen first, then alphabetical, so the list never shuffles
    -- between two identical refreshes.
    s.last_seen desc nulls last,
    lower(coalesce(p.display_name, ''))
  limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants.
-- ---------------------------------------------------------------------------
grant execute on function public.entitlement_status()               to authenticated;
grant execute on function public.admin_billing_overview()           to authenticated;
grant execute on function public.admin_users_list(text, text, int)  to authenticated;
